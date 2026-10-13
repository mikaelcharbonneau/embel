import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createNamesStore, readNamesBackup, MAX_NAMES_BYTES } from "@/components/naming/local-names";

function fixture() {
  let raw: string | null = null, fail = false;
  const store = createNamesStore({ storage: () => ({ getItem: () => raw, setItem: (_key, next) => { if (fail) throw new Error("Quota"); raw = next; } }), createId: randomUUID });
  store.hydrate();
  const add = (name: string) => { store.updateUi({ manualValue: name }); expect(store.addManual().ok).toBe(true); };
  return { store, add, raw: () => raw, setRaw: (next: string) => { raw = next; }, fail: () => { fail = true; } };
}

describe("explicit Names backup restoration", () => {
  it("restores validated names and transformation history without trusting the file revision", () => {
    const source = fixture(); source.add("Cedar"); source.store.useAsSeed(source.store.getSnapshot().data.candidates[0]!.source.id);
    source.store.updateForm({ kind: "affixes", seed: "Cedar", prefixes: "New", suffixes: "", separator: "" });
    expect(source.store.runWorkshop().ok).toBe(true);
    const target = fixture(); target.add("Replace me"); const before = target.store.getSnapshot().data;
    expect(target.store.restoreBackup(source.raw()!, before)).toEqual({ ok: true, persisted: true });
    expect(target.store.getSnapshot().data.candidates).toEqual(source.store.getSnapshot().data.candidates);
    expect(target.store.getSnapshot().data.runs).toEqual(source.store.getSnapshot().data.runs);
    expect(target.store.getSnapshot().data.revision).toBe(before.revision + 1);
    expect(readNamesBackup(target.raw()!).runs).toHaveLength(1);
  });
  it("rejects tampered history and oversized input without replacing current work", () => {
    const f = fixture(); f.add("Kept"); const before = f.store.getSnapshot().data, original = f.raw();
    const tampered = structuredClone(before); tampered.candidates[0]!.source.origin = "workshop";
    for (const raw of ["not json", JSON.stringify(tampered), " ".repeat(MAX_NAMES_BYTES + 1)]) {
      expect(f.store.restoreBackup(raw, before).ok).toBe(false);
      expect(f.store.getSnapshot().data).toBe(before); expect(f.raw()).toBe(original);
    }
  });
  it("requires a new confirmation after edits in this tab", () => {
    const f = fixture(); f.add("Kept"); const before = f.store.getSnapshot().data;
    f.add("New work"); const raw = f.raw();
    expect(f.store.restoreBackup(JSON.stringify(before), before).ok).toBe(false);
    expect(f.raw()).toBe(raw); expect(f.store.getSnapshot().data.candidates).toHaveLength(2);
  });
  it("rejects old replacement consent even when a reset reuses the revision", () => {
    const f = fixture(); f.add("First"); const before = f.store.getSnapshot().data;
    f.store.startFresh(); f.add("New work"); const raw = f.raw();
    expect(f.store.getSnapshot().data.revision).toBe(before.revision);
    expect(f.store.restoreBackup(JSON.stringify(before), before).ok).toBe(false);
    expect(f.raw()).toBe(raw);
  });
  it("preserves both this tab and the other tab on a competing durable write", () => {
    const f = fixture(); f.add("This tab"); const before = f.store.getSnapshot().data;
    const other = fixture(); other.add("Other tab"); f.setRaw(other.raw()!);
    expect(f.store.restoreBackup(other.raw()!, before).ok).toBe(false);
    expect(f.store.getSnapshot().data).toBe(before); expect(f.raw()).toBe(other.raw());
    expect(f.store.getSnapshot().storage).toBe("conflict");
  });
  it("does not discard the current workspace when the backup cannot be stored", () => {
    const f = fixture(); f.add("Kept"); const before = f.store.getSnapshot().data, original = f.raw();
    const source = fixture(); source.add("Imported"); f.fail();
    expect(f.store.restoreBackup(source.raw()!, before).ok).toBe(false);
    expect(f.store.getSnapshot().data).toBe(before); expect(f.raw()).toBe(original);
  });
});
