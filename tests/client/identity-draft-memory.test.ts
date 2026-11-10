import { describe, expect, it } from "vitest";
import { identityBasis } from "@/domain/project-identity";
import { contextSnapshotSchema } from "@/domain/projects";
import {
  createIdentityDraftMemory,
  identityDraftChanged,
  type IdentityDraft,
  type IdentityPreferenceDraft,
  type IdentityColorDraft,
} from "@/components/identity/identity-draft-memory";

const owner = "aaaaaaaa-1111-4111-8111-111111111111";
const other = "bbbbbbbb-1111-4111-8111-111111111111";
const project = "cccccccc-1111-4111-8111-111111111111";
const base = "dddddddd-1111-4111-8111-111111111111";
const preferences = { version: 1 as const, creativeLocale: "en", notes: "", avoidanceNotes: "" };
const scope = { ownerId: owner, projectId: project };
function pref(index = 0, dirty = false): IdentityPreferenceDraft {
  return {
    kind: "preferences",
    ...scope,
    projectId: `cccccccc-1111-4111-8111-${String(index).padStart(12, "0")}`,
    baselineRevision: 0,
    baseline: preferences,
    value: { creativeLocale: "en", notes: dirty ? "An unsaved local fixture" : "", avoidanceNotes: "" },
    pending: null,
  };
}
function colors(): IdentityColorDraft {
  const baseline = { swatches: [{ key: "primary", name: "Ink", hex: "#121212" }], usageNotes: "" };
  return {
    kind: "component",
    ...scope,
    baseSystemVersionId: base,
    component: "colors",
    baseline,
    value: { swatches: [{ key: "primary", name: "Ink", hex: "#" }], usageNotes: "Still typing" },
    pending: null,
  };
}
function uncertain(): IdentityColorDraft {
  const draft = colors();
  draft.value.swatches[0]!.hex = "#123456";
  const context = contextSnapshotSchema.parse({ description: "Local fixture", intake: { suppliedName: "Cedar" } });
  const references = {
    version: 1 as const,
    ...scope,
    referenceRevision: 0,
    selectedReferenceCount: 0,
    capturedAt: "2026-10-04T10:00:00Z",
    selected: [],
  };
  return {
    ...draft,
    pending: {
      request: {
        baseSystemVersionId: base,
        component: "colors",
        expectedProjectRevision: 2,
        expectedReferenceRevision: 0,
        expectedPreferencesRevision: 0,
        expectedIdentityRevision: 0,
        acceptEarlierBasis: false,
        input: { swatches: [{ key: "primary", name: "Ink", hex: "#123456" }], usageNotes: "Still typing" },
        idempotencyKey: "local-fixture-uncertain-1",
      },
      basis: identityBasis({ ...scope, context, references, preferences }),
      previousSelectionId: null,
    },
  };
}
describe("provider-owned Identity draft memory", () => {
  it("isolates preferences and component drafts by owner, project and exact base", () => {
    const memory = createIdentityDraftMemory(),
      first = colors();
    expect(memory.set(first)).toBe(true);
    expect(memory.get(first)?.kind).toBe("component");
    expect(memory.get({ ...first, ownerId: other })).toBeNull();
    expect(memory.get({ ...first, baseSystemVersionId: other })).toBeNull();
    expect(memory.list(owner, project)).toHaveLength(1);
    expect(memory.list(other, project)).toHaveLength(0);
    expect(memory.list(owner, other)).toHaveLength(0);
  });
  it("retains invalid intermediate fields without treating them as submittable domain input", () => {
    const memory = createIdentityDraftMemory(),
      draft = colors();
    memory.set(draft);
    const saved = memory.get(draft);
    expect(saved?.kind === "component" && saved.component === "colors" && saved.value.swatches[0]?.hex).toBe("#");
    expect(saved && identityDraftChanged(saved)).toBe(true);
    expect(memory.hasUnsaved()).toBe(true);
  });
  it("clones and freezes buffers so the form cannot mutate retained request evidence", () => {
    const memory = createIdentityDraftMemory(),
      draft = uncertain();
    memory.set(draft);
    draft.value.swatches[0]!.name = "Changed outside memory";
    const saved = memory.get(draft)!;
    expect(saved.kind === "component" && saved.component === "colors" && saved.value.swatches[0]?.name).toBe("Ink");
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.isFrozen(saved.pending)).toBe(true);
    expect(() => {
      (saved as IdentityColorDraft).value.swatches[0]!.name = "Mutated";
    }).toThrow();
  });
  it("returns stable snapshots and notifies only on effective storage changes", () => {
    const memory = createIdentityDraftMemory();
    let calls = 0;
    const unsubscribe = memory.subscribe(() => {
      calls += 1;
    });
    const empty = memory.list(owner, project);
    expect(memory.list(owner, project)).toBe(empty);
    const draft = colors();
    memory.set(draft);
    const saved = memory.list(owner, project);
    expect(saved).not.toBe(empty);
    expect(memory.list(owner, project)).toBe(saved);
    memory.set(draft);
    expect(calls).toBe(1);
    memory.remove(draft);
    expect(calls).toBe(2);
    memory.remove(draft);
    expect(calls).toBe(2);
    unsubscribe();
    memory.set(draft);
    expect(calls).toBe(2);
  });
  it("evicts only a clean cache entry when retaining another project", () => {
    const memory = createIdentityDraftMemory();
    for (let index = 0; index < 20; index++) expect(memory.set(pref(index, index !== 4))).toBe(true);
    expect(memory.set(pref(20, true))).toBe(true);
    expect(memory.get(pref(4))).toBeNull();
    expect(memory.get(pref(0))?.value).toEqual(pref(0, true).value);
  });
  it("refuses a new draft at all-dirty capacity and still permits existing drafts to resolve", () => {
    const memory = createIdentityDraftMemory();
    for (let index = 0; index < 20; index++) memory.set(pref(index, true));
    expect(memory.set(pref(20, true))).toBe(false);
    expect(memory.get(pref(0))?.value).toEqual(pref(0, true).value);
    memory.remove(pref(0));
    expect(memory.set(pref(20, true))).toBe(true);
  });
  it("keeps uncertain requests unsaved across repeated snapshots and same-owner recovery", () => {
    const memory = createIdentityDraftMemory(),
      draft = uncertain();
    memory.set(draft);
    const recovered = memory.list(owner, project)[0]!;
    expect(recovered.pending).toEqual(draft.pending);
    expect(memory.hasUnsaved()).toBe(true);
    expect(memory.set({ ...draft, pending: null })).toBe(false);
    expect(memory.get(draft)?.pending).toEqual(draft.pending);
    const altered = uncertain();
    altered.pending!.request.expectedReferenceRevision = 1;
    expect(memory.set(altered)).toBe(false);
    expect(memory.get(draft)?.pending).toEqual(draft.pending);
    memory.remove(draft);
    expect(memory.hasUnsaved()).toBe(false);
  });
  it("counts a pending preference write as unsaved even if its fields equal the baseline", () => {
    const memory = createIdentityDraftMemory(),
      draft = pref();
    draft.pending = { request: { expectedPreferencesRevision: 0, preferences } };
    memory.set(draft);
    expect(memory.hasUnsaved()).toBe(true);
    expect(memory.set({ ...draft, pending: null })).toBe(false);
  });
  it("rejects foreign or internally inconsistent uncertain evidence without altering memory", () => {
    const memory = createIdentityDraftMemory(),
      draft = uncertain();
    memory.set(draft);
    const altered = structuredClone(draft);
    altered.pending!.basis.ownerId = other;
    expect(() => memory.set(altered)).toThrow();
    expect(memory.get(draft)?.pending).toEqual(draft.pending);
    const wrongComponent = structuredClone(draft) as unknown as IdentityDraft;
    if (wrongComponent.kind === "component" && wrongComponent.pending)
      wrongComponent.pending.request.baseSystemVersionId = other;
    expect(() => memory.set(wrongComponent)).toThrow();
  });
  it("does not replace the baseline of a dirty draft during a later overview read", () => {
    const memory = createIdentityDraftMemory(),
      draft = pref(0, true);
    memory.set(draft);
    expect(memory.set({ ...draft, baselineRevision: 1, baseline: { ...preferences, notes: "Saved elsewhere" } })).toBe(
      false,
    );
    expect(memory.get(draft)).toEqual(draft);
    memory.remove(draft);
    expect(memory.set({ ...draft, baselineRevision: 1, baseline: { ...preferences, notes: "Saved elsewhere" } })).toBe(
      true,
    );
  });
  it("clears every owner buffer and uncertain intent on the provider's confirmed discard", () => {
    const memory = createIdentityDraftMemory();
    memory.set(uncertain());
    memory.set(pref(0, true));
    memory.clear();
    expect(memory.hasUnsaved()).toBe(false);
    expect(memory.list(owner, project)).toHaveLength(0);
    expect(memory.get(pref())).toBeNull();
  });
});
