import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { contextSnapshotSchema } from "@/domain/projects";
import { createNamesStore, MAX_NAMES, MAX_NAMES_BYTES, NAMES_STORAGE_KEY, namesWorkspaceSchema } from "@/components/naming/local-names";

// In-memory browser-storage fixtures only. No browser, account, or provider access.
function storageFixture(initial: string | null = null) {
  let raw = initial;
  let blocked = false;
  let writes = 0;
  const storage = {
    getItem(key: string) { expect(key).toBe(NAMES_STORAGE_KEY); return raw; },
    setItem(key: string, value: string) {
      expect(key).toBe(NAMES_STORAGE_KEY);
      if (blocked) throw new DOMException("Synthetic browser quota failure", "QuotaExceededError");
      raw = value;
      writes += 1;
    },
  };
  return {
    storage, read: () => raw, writes: () => writes,
    setRaw(value: string | null) { raw = value; },
    block(value: boolean) { blocked = value; },
  };
}

function createStore(fixture: ReturnType<typeof storageFixture>) {
  const store = createNamesStore({ storage: () => fixture.storage, createId: randomUUID, now: () => "2026-10-02T12:00:00Z" });
  store.hydrate();
  return store;
}

describe("independent naming storage failure recovery", () => {
  it("keeps a failed write in memory, then saves that exact work on retry", () => {
    const fixture = storageFixture();
    const store = createStore(fixture);
    expect(store.addManual("First local fixture")).toMatchObject({ ok: true, persisted: true });
    const readable = fixture.read();
    fixture.block(true);
    const result = store.addManual("Unsaved local fixture");
    expect(result.persisted).toBe(false);
    expect(fixture.read()).toBe(readable);
    expect(store.getSnapshot().data.candidates.map((candidate) => candidate.source.value)).toContain("Unsaved local fixture");
    expect(store.getSnapshot().dirty).toBe(true);
    const retained = structuredClone(store.getSnapshot().data);

    fixture.block(false);
    expect(store.retrySave()).toMatchObject({ ok: true, persisted: true });
    expect(JSON.parse(fixture.read()!)).toEqual(retained);
    expect(store.getSnapshot().dirty).toBe(false);
  });

  it("does not discard unsaved names or overwrite another tab during a storage conflict", () => {
    const fixture = storageFixture();
    const first = createStore(fixture);
    first.addManual("Original fixture");
    fixture.block(true);
    first.addManual("First tab unsaved fixture");
    const unsaved = structuredClone(first.getSnapshot().data);

    fixture.block(false);
    const second = createStore(fixture);
    second.addManual("Second tab saved fixture");
    const remote = fixture.read();
    first.onStorageChange();
    expect(first.getSnapshot()).toMatchObject({ storage: "conflict", dirty: true });
    expect(first.getSnapshot().data).toEqual(unsaved);
    expect(first.retrySave().persisted).toBe(false);
    expect(first.getSnapshot().data).toEqual(unsaved);
    expect(fixture.read()).toBe(remote);

    first.loadSaved();
    expect(first.getSnapshot().data).toEqual(second.getSnapshot().data);
  });

  it("detects another tab's write before a mutation even when no storage event was delivered", () => {
    const fixture = storageFixture();
    const first = createStore(fixture);
    first.addManual("Original fixture");
    const originalId = first.getSnapshot().data.candidates[0]!.source.id;
    const second = createStore(fixture);
    second.addManual("Other tab fixture");
    const remote = fixture.read();
    expect(first.togglePreference(originalId, "favorite").persisted).toBe(false);
    expect(first.getSnapshot().storage).toBe("conflict");
    expect(fixture.read()).toBe(remote);
  });

  it("retains a clean tab's newly saved names when writes interleave at the same revision", () => {
    const fixture = storageFixture();
    const first = createStore(fixture);
    first.addManual("Shared original fixture");
    let interleave: (() => void) | undefined;
    const second = createNamesStore({
      storage: () => ({
        getItem: fixture.storage.getItem,
        setItem(key, value) {
          // Simulate the first tab writing after the second tab checked its base,
          // but before the second tab's setItem completes. localStorage has no CAS.
          const action = interleave;
          interleave = undefined;
          action?.();
          fixture.storage.setItem(key, value);
        },
      }), createId: randomUUID, now: () => "2026-10-02T12:00:00Z",
    });
    second.hydrate();
    interleave = () => { expect(first.addManual("First concurrent fixture").persisted).toBe(true); };
    expect(second.addManual("Second concurrent fixture").persisted).toBe(true);
    expect(first.getSnapshot().dirty).toBe(false);
    expect(first.getSnapshot().data.revision).toBe(second.getSnapshot().data.revision);
    const retained = structuredClone(first.getSnapshot().data);
    const remote = fixture.read();

    first.onStorageChange();
    expect(first.getSnapshot()).toMatchObject({ storage: "conflict", dirty: true });
    expect(first.getSnapshot().data).toEqual(retained);
    expect(first.retrySave().persisted).toBe(false);
    expect(fixture.read()).toBe(remote);
  });

  it.each(["remove", "rewrite"] as const)("preserves captured work when a higher revision tries to %s an immutable source", (change) => {
    const fixture = storageFixture();
    const store = createStore(fixture);
    store.addManual("Immutable original fixture");
    const retained = structuredClone(store.getSnapshot().data);
    const incoming = structuredClone(retained);
    incoming.revision += 1;
    if (change === "remove") incoming.candidates = [];
    else incoming.candidates[0]!.source.value = "Rewritten fixture";
    expect(namesWorkspaceSchema.safeParse(incoming).success).toBe(true);
    fixture.setRaw(JSON.stringify(incoming));
    store.onStorageChange();
    expect(store.getSnapshot()).toMatchObject({ storage: "conflict", dirty: true });
    expect(store.getSnapshot().data).toEqual(retained);
  });

  it("does not overwrite malformed browser data through normal actions or retry", () => {
    const corrupt = '{"version":1,"candidates":';
    const fixture = storageFixture(corrupt);
    const store = createStore(fixture);
    expect(store.getSnapshot().storage).toBe("invalid");
    expect(store.addManual("Must not replace corrupt work").persisted).toBe(false);
    expect(store.retrySave().persisted).toBe(false);
    expect(fixture.read()).toBe(corrupt);
    expect(fixture.writes()).toBe(0);
  });

  it("does not apply an earlier recovery choice to newly changed corrupt data", () => {
    const fixture = storageFixture("first corrupt fixture");
    const store = createStore(fixture);
    store.addManual("Recovered in-memory fixture");
    const retained = structuredClone(store.getSnapshot().data);
    fixture.setRaw("second corrupt fixture");
    expect(store.replaceInvalid().persisted).toBe(false);
    expect(store.getSnapshot().data).toEqual(retained);
    expect(fixture.read()).toBe("second corrupt fixture");
    expect(fixture.writes()).toBe(0);
    expect(store.replaceInvalid()).toMatchObject({ ok: true, persisted: true });
    expect(JSON.parse(fixture.read()!)).toEqual(retained);
  });

  it("rejects a whole over-capacity workshop run without evicting captured names", () => {
    const fixture = storageFixture();
    const seedStore = createStore(fixture);
    seedStore.addManual("Capacity fixture");
    const data = structuredClone(seedStore.getSnapshot().data);
    const template = data.candidates[0]!;
    data.candidates = Array.from({ length: MAX_NAMES - 1 }, (_, index) => ({
      ...structuredClone(template), source: { ...structuredClone(template.source), id: randomUUID(), value: `Capacity fixture ${index}` },
    }));
    expect(namesWorkspaceSchema.safeParse(data).success).toBe(true);
    fixture.setRaw(JSON.stringify(data));
    const store = createStore(fixture);
    const before = structuredClone(store.getSnapshot().data);
    const rawBefore = fixture.read();
    expect(store.runWorkshop({ kind: "affixes", seed: "Room", prefixes: ["One", "Two"], suffixes: ["Lab"], separator: " " }).ok).toBe(false);
    expect(store.getSnapshot().data).toEqual(before);
    expect(fixture.read()).toBe(rawBefore);
  });

  it("applies the serialized byte limit to multibyte captured context", () => {
    const fixture = storageFixture();
    const seedStore = createStore(fixture);
    seedStore.addManual("Unicode capacity fixture");
    const data = structuredClone(seedStore.getSnapshot().data);
    const template = data.candidates[0]!;
    const context = contextSnapshotSchema.parse({ description: "😀".repeat(6_000) });
    data.candidates = Array.from({ length: 180 }, (_, index) => ({
      ...structuredClone(template), context: structuredClone(context),
      source: { ...structuredClone(template.source), id: randomUUID(), value: `Unicode capacity fixture ${index}` },
    }));
    const oversized = JSON.stringify(data);
    expect(oversized.length).toBeLessThan(MAX_NAMES_BYTES);
    expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(MAX_NAMES_BYTES);
    fixture.setRaw(oversized);
    const store = createStore(fixture);
    expect(store.getSnapshot().storage).toBe("invalid");
    expect(store.retrySave().persisted).toBe(false);
    expect(fixture.read()).toBe(oversized);
  });
});

describe("independent naming capture integrity", () => {
  it("does not allow a consumer to replace the trusted graph through the exposed snapshot wrapper", () => {
    const fixture = storageFixture();
    const store = createStore(fixture);
    store.addManual("Original trusted fixture");
    const exposed = store.getSnapshot();
    const original = exposed.data;
    const forged = structuredClone(original);
    forged.candidates[0]!.source.origin = "workshop";
    // Inner values are frozen; the wrapper must not allow replacing that entire
    // graph before a UI-only mutation relies on its already-validated identity.
    Reflect.set(exposed, "data", forged);
    expect(store.getSnapshot().data).toBe(original);
    expect(store.updateUi({ query: "Original" }).ok).toBe(true);
    expect(store.getSnapshot().data.candidates[0]!.source.origin).toBe("manual");
    expect(namesWorkspaceSchema.safeParse(JSON.parse(fixture.read()!)).success).toBe(true);
  });

  it("keeps spaces while context is being typed and normalizes only the captured snapshot", () => {
    const fixture = storageFixture();
    const store = createStore(fixture);
    store.updateContext({ description: "A ", knownAudience: "Local " });
    expect(store.getSnapshot().data.ui.context).toMatchObject({ description: "A ", knownAudience: "Local " });
    store.updateContext({ description: "A local workshop " });
    store.addManual("Typing fixture");
    expect(store.getSnapshot().data.ui.context.description).toBe("A local workshop ");
    expect(store.getSnapshot().data.candidates[0]!.context).toMatchObject({ description: "A local workshop", knownAudience: "Local" });
  });

  it("rejects a fourth comparison without replacing any prior selection", () => {
    const fixture = storageFixture();
    const store = createStore(fixture);
    for (const value of ["One fixture", "Two fixture", "Three fixture", "Four fixture"]) store.addManual(value);
    const ids = store.getSnapshot().data.candidates.map((candidate) => candidate.source.id);
    for (const id of ids.slice(0, 3)) expect(store.toggleComparison(id).ok).toBe(true);
    const before = fixture.read();
    expect(store.toggleComparison(ids[3]!).ok).toBe(false);
    expect(store.getSnapshot().data.ui.comparisonIds).toEqual(ids.slice(0, 3));
    expect(fixture.read()).toBe(before);
  });

  it("validates reference links and unknown fields on the UI-only mutation path", () => {
    const fixture = storageFixture();
    const store = createStore(fixture);
    store.addManual("Existing reference fixture");
    const id = store.getSnapshot().data.candidates[0]!.source.id;
    const original = structuredClone(store.getSnapshot().data);
    const persisted = fixture.read();
    for (const patch of [
      { comparisonIds: [randomUUID()] },
      { comparisonIds: [id, id] },
      { activeRunId: randomUUID() },
      { query: "Fixture", screeningStatus: "cleared" },
    ]) {
      expect(store.updateUi(patch).ok).toBe(false);
      expect(store.getSnapshot().data).toEqual(original);
      expect(fixture.read()).toBe(persisted);
    }
  });

  it("copies captured context and keeps favorite and saved choices independent", () => {
    const fixture = storageFixture();
    const store = createStore(fixture);
    const context = contextSnapshotSchema.parse({ description: "Original captured brief", competitors: [{ id: randomUUID(), name: "Supplied fixture", relevance: "User supplied", origin: "user" }] });
    store.updateContext(context);
    store.addManual("Captured fixture");
    const captured = structuredClone(store.getSnapshot().data.candidates[0]!);
    context.description = "Caller mutated context";
    context.competitors[0]!.name = "Caller mutated competitor";
    store.updateContext({ description: "Future brief only" });
    expect(store.getSnapshot().data.candidates[0]).toEqual(captured);

    const id = captured.source.id;
    store.togglePreference(id, "favorite");
    expect(store.getSnapshot().data.candidates[0]).toMatchObject({ favorite: true, saved: captured.saved });
    store.togglePreference(id, "saved");
    expect(store.getSnapshot().data.candidates[0]).toMatchObject({ favorite: true, saved: !captured.saved });
    store.togglePreference(id, "favorite");
    expect(store.getSnapshot().data.candidates[0]).toMatchObject({ favorite: false, saved: !captured.saved });
    expect(store.getSnapshot().data.candidates[0]!.source).toEqual(captured.source);
    expect(store.getSnapshot().data.candidates[0]!.context).toEqual(captured.context);
  });

  it("rejects cross-linked run outputs, duplicated IDs, and foreign candidate context", () => {
    const fixture = storageFixture();
    const store = createStore(fixture);
    store.runWorkshop({ kind: "affixes", seed: "Room", prefixes: ["One", "Two"], suffixes: ["Lab"], separator: " " });
    const original = structuredClone(store.getSnapshot().data);
    expect(original.candidates.length).toBeGreaterThanOrEqual(2);
    expect(namesWorkspaceSchema.safeParse(original).success).toBe(true);

    const crossLinked = structuredClone(original);
    crossLinked.runs[0]!.candidateIds[0] = randomUUID();
    expect(namesWorkspaceSchema.safeParse(crossLinked).success).toBe(false);
    const duplicate = structuredClone(original);
    duplicate.candidates[1]!.source.id = duplicate.candidates[0]!.source.id;
    expect(namesWorkspaceSchema.safeParse(duplicate).success).toBe(false);
    const foreignContext = structuredClone(original);
    foreignContext.candidates[0]!.context.description = "A different brief";
    expect(namesWorkspaceSchema.safeParse(foreignContext).success).toBe(false);
    const tamperedHistory = structuredClone(original);
    tamperedHistory.candidates[0]!.source.history[0]!.output = "Unrelated result";
    expect(namesWorkspaceSchema.safeParse(tamperedHistory).success).toBe(false);
  });

  it("returns validation failure for an oversized persisted run without throwing during replay", () => {
    const fixture = storageFixture();
    const store = createStore(fixture);
    store.runWorkshop({ kind: "affixes", seed: "Room", prefixes: ["One"], suffixes: ["Lab"], separator: " " });
    const malformed = structuredClone(store.getSnapshot().data);
    const input = malformed.runs[0]!.input;
    if (input.kind !== "affixes") throw new Error("Expected the local affixes fixture");
    input.prefixes = Array.from({ length: 13 }, (_, index) => `Prefix ${index}`);
    expect(() => namesWorkspaceSchema.safeParse(malformed)).not.toThrow();
    expect(namesWorkspaceSchema.safeParse(malformed).success).toBe(false);
    const raw = JSON.stringify(malformed);
    fixture.setRaw(raw);
    const restored = createStore(fixture);
    expect(restored.getSnapshot().storage).toBe("invalid");
    expect(fixture.read()).toBe(raw);
  });
});
