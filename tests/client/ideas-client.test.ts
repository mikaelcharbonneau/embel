import { describe, expect, it } from "vitest";
import { ideaContentSchema, ideaRecordSchema, ideaPageSchema } from "@/domain/ideas";
import { AccountRequestError } from "@/components/workspace/account-api";

const ownerA = "aaaaaaaa-1111-4111-8111-111111111111";
const ownerB = "bbbbbbbb-1111-4111-8111-111111111111";
const when = "2026-10-05T10:00:00.123456Z";
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
function record(value = 1, ownerId = ownerA) {
  return ideaRecordSchema.parse({ id: id(value), ownerId, revision: 1, content: { title: `Account fixture ${value}` }, createdAt: when, updatedAt: when, links: [] });
}
function workspace(value = 1, ownerId = ownerA) {
  const saved = record(value, ownerId);
  return { ownerId, generation: 1, saved, content: saved.content, conflict: false, saveIntent: null, brandIntent: null };
}
async function memoryModule() {
  const implementation = await import("@/components/ideas/ideas-draft-memory").catch(() => null);
  expect(implementation, "The approved Ideas memory store must exist").not.toBeNull();
  return implementation!;
}

describe("owner-bound Ideas memory", () => {
  it("retains dirty account content and its retry receipt without browser persistence", async () => {
    const { createIdeaDraftMemory } = await memoryModule();
    const memory = createIdeaDraftMemory(); const entry = workspace();
    const edited = { ...entry.content, title: "Private pending edit" };
    const intent = { requestKey: id(999), expectedRevision: 1, content: edited };
    memory.set({ ...entry, content: edited, saveIntent: intent });
    expect(memory.get(ownerA, entry.saved.id)).toMatchObject({ content: edited, saveIntent: intent });
    expect(memory.hasUnsaved()).toBe(true);
    memory.set({ ...entry, saved: { ...entry.saved, revision: 2, content: edited }, content: edited });
    expect(memory.hasUnsaved()).toBe(false);
  });
  it("refuses cross-owner reads and writes until a confirmed clear", async () => {
    const { createIdeaDraftMemory } = await memoryModule();
    const memory = createIdeaDraftMemory();
    expect(memory.set(workspace())).toBe(true);
    expect(memory.get(ownerB, id(1))).toBeNull();
    expect(memory.set(workspace(2, ownerB))).toBe(false);
    expect(memory.set({ ...workspace(), ownerId: ownerB })).toBe(false);
    memory.clear();
    expect(memory.get(ownerA, id(1))).toBeNull();
    expect(memory.hasUnsaved()).toBe(false);
    expect(memory.set(workspace(2, ownerB))).toBe(true);
  });
  it("keeps unfinished quick capture private and clears it after a confirmed creation", async () => {
    const { createIdeaDraftMemory } = await memoryModule();
    const memory = createIdeaDraftMemory();
    const content = ideaContentSchema.parse({ title: "Private quick capture" });
    const capture = { ownerId: ownerA, generation: 1, content, intent: { requestKey: id(800), content } };
    expect(memory.setCapture(capture)).toBe(true);
    expect(memory.hasUnsaved()).toBe(true);
    expect(memory.getCapture(ownerB)).toBeNull();
    memory.clearCapture(ownerB);
    expect(memory.getCapture(ownerA)).toEqual(capture);
    memory.clearCapture(ownerA);
    expect(memory.getCapture(ownerA)).toBeNull();
    expect(memory.hasUnsaved()).toBe(false);
  });
  it("does not evict any unsaved entries when its tab limit is reached", async () => {
    const { createIdeaDraftMemory } = await memoryModule();
    const memory = createIdeaDraftMemory();
    for (let index = 1; index <= 20; index += 1) {
      const entry = workspace(index);
      expect(memory.set({ ...entry, content: { ...entry.content, description: "Unsaved private note" } })).toBe(true);
    }
    expect(memory.set(workspace(21))).toBe(false);
    expect(memory.get(ownerA, id(1))?.content.description).toBe("Unsaved private note");
    memory.set(workspace(1));
    expect(memory.set(workspace(21))).toBe(true);
    expect(memory.get(ownerA, id(1))).toBeNull();
  });
  it("requires recovery before an unconfirmed save or brand request can be discarded", async () => {
    const { createIdeaDraftMemory } = await memoryModule();
    const memory = createIdeaDraftMemory(); const entry = workspace();
    memory.set({ ...entry, brandIntent: { requestKey: id(800), expectedRevision: 1 } });
    expect(memory.hasUnsaved()).toBe(true);
    memory.set({ ...entry, saveIntent: { requestKey: id(900), expectedRevision: 1, content: entry.content } });
    expect(memory.hasUnsaved()).toBe(true);
    memory.set(entry);
    expect(memory.hasUnsaved()).toBe(false);
  });
});

describe("Ideas listing continuation", () => {
  const page = (values: number[], next: boolean) => ideaPageSchema.parse({ ownerId: ownerA, items: values.map(value => { const item = record(value); return { id: item.id, ownerId: item.ownerId, revision: item.revision, title: item.content.title, description: item.content.description, theme: item.content.theme, state: item.content.state, createdAt: item.createdAt, updatedAt: item.updatedAt }; }), nextCursor: next ? { createdAt: when, id: id(values.at(-1)!) } : null });
  async function clientModule() {
    const implementation = await import("@/components/ideas/ideas-client").catch(() => null);
    expect(implementation, "Ideas continuation must validate bound page merges").not.toBeNull(); return implementation!;
  }
  it("preserves strict ordering and exact microsecond cursors when appending an owned page", async () => {
    const { mergeIdeaPage } = await clientModule();
    const first = page([5, 4], true); const second = page([3, 2], false);
    expect(mergeIdeaPage(first, second, first.nextCursor)).toMatchObject({ items: [...first.items, ...second.items], nextCursor: null });
  });
  it("rejects duplicate, foreign, obsolete and non-descending page continuations", async () => {
    const { mergeIdeaPage } = await clientModule(); const first = page([5, 4], true);
    expect(() => mergeIdeaPage(first, page([4, 3], false), first.nextCursor)).toThrow();
    expect(() => mergeIdeaPage(first, page([6, 3], false), first.nextCursor)).toThrow();
    expect(() => mergeIdeaPage(first, { ...page([3, 2], false), ownerId: ownerB }, first.nextCursor)).toThrow();
    expect(() => mergeIdeaPage(first, page([3, 2], false), { createdAt: when, id: id(3) })).toThrow();
  });
});

describe("Ideas request recovery messages", () => {
  it("separates unavailable reads from unconfirmed writes and never prints internal errors", async () => {
    const { ideaErrorMessage } = await import("@/components/ideas/ideas-client");
    expect(ideaErrorMessage(new AccountRequestError(503), true)).toContain("could not be confirmed");
    expect(ideaErrorMessage(new AccountRequestError(503))).not.toContain("may have completed");
    expect(ideaErrorMessage(new Error("private database details"), true)).not.toContain("private database");
  });
});
