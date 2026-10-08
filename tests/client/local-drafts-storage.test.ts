import { afterEach, expect, it, vi } from "vitest";
import type { LocalDraft } from "@/components/workspace/local-drafts";

function largeDraft(index: number): LocalDraft {
  return {
    id: `aaaaaaaa-1111-4111-8111-${String(index).padStart(12, "0")}`,
    title: `Local capacity fixture ${index}`, scope: "naming_only", description: "A schema-valid local browser draft capacity fixture.",
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
