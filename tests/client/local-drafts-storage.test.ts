import { afterEach, expect, it, vi } from "vitest";
import type { LocalDraft } from "@/components/workspace/local-drafts";

function largeDraft(index: number): LocalDraft {
  return {
    id: `aaaaaaaa-1111-4111-8111-${String(index).padStart(12, "0")}`,
    title: `Local capacity fixture ${index}`, scope: "complete_brand", description: "A schema-valid local browser draft capacity fixture.",
    activity: "Kitchen", offering: "Lunch", knownAudience: "Workers", suppliedName: "", namingNotes: "Keep these unsaved notes", identityNotes: "",
    stage: "audience", audienceReviewedAt: null, example: false, createdAt: "2026-10-02T10:00:00Z", updatedAt: "2026-10-02T10:00:00Z",
    segments: Array.from({ length: 30 }, (_, segment) => ({
      id: `bbbbbbbb-1111-4111-8111-${String(segment).padStart(12, "0")}`, name: "Capacity fixture", needs: "n".repeat(24_011), reason: "A local fixture", selected: false,
    })),
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("keeps an oversized workspace in memory without replacing the last readable save, even when storage accepts unlimited writes", async () => {
  vi.resetModules();
  const drafts = Array.from({ length: 11 }, (_, index) => largeDraft(index));
  const lastReadable = JSON.stringify({ version: 1, drafts });
  expect(lastReadable.length).toBeLessThanOrEqual(8_000_000);
  expect(JSON.stringify({ version: 1, drafts: [largeDraft(12), ...drafts] }).length).toBeGreaterThan(8_000_000);
  let storedValue = lastReadable;
  // Deliberately imposes no browser quota: the application must enforce its own readable limit.
  const setItem = vi.fn((_key: string, value: string) => { storedValue = value; });
  vi.stubGlobal("window", { localStorage: { getItem: () => storedValue, setItem } });
  const { copyToLocalDraft, updateLocalDraft } = await import("@/components/workspace/local-drafts");

  const copy = copyToLocalDraft(largeDraft(12));
  expect(copy).toMatchObject({ persisted: false });
  expect(setItem).not.toHaveBeenCalled();
  expect(storedValue).toBe(lastReadable);

  // Editing the retained copy back below the limit must save all its other in-memory fields.
  expect(updateLocalDraft(copy!.id, { segments: [] })).toBe(true);
  expect(setItem).toHaveBeenCalledTimes(1);
  expect(storedValue.length).toBeLessThanOrEqual(8_000_000);
  const recovered = JSON.parse(storedValue).drafts as LocalDraft[];
  expect(recovered).toHaveLength(12);
  expect(recovered.find((draft) => draft.id === copy!.id)).toMatchObject({ title: "Local capacity fixture 12", namingNotes: "Keep these unsaved notes", segments: [] });
});

it("reclaims only confirmed account copies at capacity and preserves every unsaved legacy draft", async () => {
  vi.resetModules();
  const drafts = Array.from({ length: 50 }, (_, index) => ({ ...largeDraft(index), segments: [], ...(index > 0 ? { ownerId: "cccccccc-1111-4111-8111-111111111111", accountProjectId: `dddddddd-1111-4111-8111-${String(index).padStart(12, "0")}` } : {}) }));
  let stored = JSON.stringify({ version: 1, drafts });
  vi.stubGlobal("window", { localStorage: { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } } });
  const { createLocalDraft } = await import("@/components/workspace/local-drafts");
  const id = createLocalDraft({ title: "New account project", description: "Another project", scope: "complete_brand", suppliedName: "", namingNotes: "", identityNotes: "", example: false, ownerId: "cccccccc-1111-4111-8111-111111111111" });
  expect(id).not.toBeNull();
  expect(JSON.parse(stored).drafts).toHaveLength(2);
  expect(JSON.parse(stored).drafts.find((draft: LocalDraft) => draft.id === drafts[0]!.id)).toEqual(drafts[0]);
});

it("does not overwrite unreadable legacy data when retaining a new account prompt", async () => {
  vi.resetModules(); const original = '{"version":1,"drafts":[unreadable legacy bytes';
  let stored = original;
  vi.stubGlobal("window", { localStorage: { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } } });
  const { createLocalDraft, getLocalDraft, clearLocalDrafts } = await import("@/components/workspace/local-drafts");
  const id = createLocalDraft({ title: "New account prompt", description: "Keep this current prompt", scope: "complete_brand", suppliedName: "", namingNotes: "", identityNotes: "", example: false });
  expect(getLocalDraft(id!)?.description).toBe("Keep this current prompt"); expect(stored).toBe(original);
  expect(clearLocalDrafts()).toBe(true); expect(JSON.parse(stored).drafts).toEqual([]);
});
