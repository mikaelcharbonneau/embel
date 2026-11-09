import { describe, expect, it } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import { createAccountDraftMemory } from "@/components/workspace/account-draft-memory";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";

function entry(index: number, dirty = false) {
  const saved = accountProjectSchema.parse({ id: `aaaaaaaa-1111-4111-8111-${String(index).padStart(12, "0")}`, owner_id: "bbbbbbbb-1111-4111-8111-111111111111", scope: "complete_brand", title: `Local memory fixture ${index}`, current_revision: 1, created_at: "2026-10-02T10:00:00Z", context: {} });
  const draft = accountProjectDraft(saved);
  if (dirty) draft.namingNotes = "An unsaved note";
  return { generation: 1, ownerId: saved.owner_id, saved, draft, conflict: false };
}
describe("bounded account draft memory", () => {
  it("evicts clean cache entries before any unsaved work", () => {
    const memory = createAccountDraftMemory();
    for (let index = 0; index < 20; index++) expect(memory.set(entry(index, index !== 3))).toBe(true);
    expect(memory.set(entry(20, true))).toBe(true);
    expect(memory.get(entry(3).saved.id)).toBeNull();
    expect(memory.get(entry(0).saved.id)?.draft.namingNotes).toBe("An unsaved note");
  });
  it("refuses new projects at capacity instead of dropping unsaved drafts, while allowing existing drafts to save", () => {
    const memory = createAccountDraftMemory();
    for (let index = 0; index < 20; index++) memory.set(entry(index, true));
    expect(memory.set(entry(20))).toBe(false);
    expect(memory.get(entry(0).saved.id)?.draft.namingNotes).toBe("An unsaved note");
    expect(memory.set(entry(0))).toBe(true);
    expect(memory.set(entry(20))).toBe(true);
    expect(memory.hasUnsaved()).toBe(true);
    memory.clear();
    expect(memory.hasUnsaved()).toBe(false);
    expect(memory.get(entry(1).saved.id)).toBeNull();
  });
  it("retains unsent conversation text and choices at capacity without treating either as a project PATCH", () => {
    const memory = createAccountDraftMemory();
    for (let index = 0; index < 20; index++) memory.set({ ...entry(index), guidedInput: index % 2 ? { prompt: "An unsent question", selection: null } : { prompt: "", selection: { turnId: "saved-turn", ids: ["unconfirmed-choice"] } } });
    expect(memory.hasUnsaved()).toBe(true);
    expect(memory.set(entry(20))).toBe(false);
    expect(memory.get(entry(0).saved.id)?.guidedInput?.selection?.ids).toEqual(["unconfirmed-choice"]);
    expect(memory.get(entry(1).saved.id)?.guidedInput?.prompt).toBe("An unsent question");
    memory.set({ ...entry(0), guidedInput: { prompt: "", selection: null } });
    expect(memory.set(entry(20))).toBe(true);
    expect(memory.get(entry(0).saved.id)).toBeNull();
  });
});
