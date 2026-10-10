import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addGuidedWords, applyGuidedTweak, emptyGuidedUi, previewGuidedNames, tweakChoices } from "@/components/naming/guided-names";
import { createEmptyNamesWorkspace, createNamesStore, namesWorkspaceSchema } from "@/components/naming/local-names";
import { namingSourceSchema, transformNames, type NameTransformInput } from "@/domain/naming";

const words = (...values: string[]) => values.map(value => ({ value, candidateId: null }));
function fixture() {
  let raw: string | null = null;
  const store = createNamesStore({ storage: () => ({ getItem: () => raw, setItem: (_key, next) => { raw = next; } }), createId: randomUUID });
  store.hydrate(); return { store, raw: () => raw, replaceRaw: (next: string) => { raw = next; } };
}
describe("guided Names preview", () => {
  it("starts empty, normalizes and deduplicates words without dropping retained lineage", () => {
    expect(previewGuidedNames(emptyGuidedUi()).results).toEqual([]);
    const id = randomUUID();
    const next = addGuidedWords({ ...emptyGuidedUi(), words: [{ value: "Café", candidateId: id }], draft: " Café, next\nnext " });
    expect(next.words).toEqual([{ value: "Café", candidateId: id }, { value: "next", candidateId: null }]);
    expect(() => addGuidedWords({ ...emptyGuidedUi(), draft: "ok, bad\u0000" })).toThrow();
  });
  it("lists affixes independently and replays each tweak in fixed design order", () => {
    const ui = { ...emptyGuidedUi(), words: words("Mikael"), prefixes: ["Neo"], suffixes: ["son"] };
    expect(previewGuidedNames(ui).results.map(r => r.value)).toEqual(["NeoMikael", "Mikaelson"]);
    const result = previewGuidedNames({ ...emptyGuidedUi(), words: words("Mikael"), tweaks: ["double_last", "reverse"] }).results[0]!;
    expect(result.value).toBe("Leakimm");
    let current = "Mikael";
    for (const input of result.inputs) { expect(input.kind === "blend" ? input.left : input.seed).toBe(current); current = transformNames(input).candidates[0]!.value; }
    expect(current).toBe(result.value);
  });
  it("implements the ten shown examples without splitting grapheme clusters", () => {
    const examples = ["Leakim", "latr", "Mkl", "Mi-Mikael", "Ikaelmay", "Meakil", "letir", "Mikaeleakim", "laterr", "MiKaEl"];
    tweakChoices.forEach((tweak, i) => expect(applyGuidedTweak([1, 6, 8].includes(i) ? "later" : "Mikael", tweak.id)).toBe(examples[i]));
    expect(applyGuidedTweak("👩‍💻a", "reverse")).toBe("a👩‍💻");
    const invalid = previewGuidedNames({ ...emptyGuidedUi(), words: words("aeiou"), tweaks: ["strip_vowels"] });
    expect(invalid.results).toEqual([]); expect(invalid.omitted).toBe(1);
  });
  it("blends original words in both directions, deduplicates and records literal cleaning", () => {
    const ui = { ...emptyGuidedUi(), mode: "blend" as const, words: words("smoke", "fog"), prefixes: ["Neo"], tweaks: ["reverse" as const] };
    const result = previewGuidedNames(ui);
    expect(result.results.map(r => r.value)).toContain("smog");
    expect(result.results.some(r => r.origin === "fog + smoke")).toBe(true);
    expect(new Set(result.results.map(r => r.value)).size).toBe(result.results.length);
    const cleaned = previewGuidedNames({ ...ui, words: words("sm-oke", "f og") }).results;
    expect(cleaned.some(r => r.value === "smog" && r.inputs[0]!.kind === "swap")).toBe(true);
    expect(cleaned.every(r => !r.value.includes("-") && !r.value.includes(" "))).toBe(true);
  });
  it("uses original words for deterministic swap levels and bounds combinatorial previews", () => {
    const ui = { ...emptyGuidedUi(), mode: "swap" as const, words: words("later"), prefixes: ["Neo"], tweaks: ["reverse" as const] };
    const safe = previewGuidedNames({ ...ui, swapLevel: "safe" }), balanced = previewGuidedNames(ui), creative = previewGuidedNames({ ...ui, swapLevel: "creative" });
    expect(safe.results.length).toBeLessThan(balanced.results.length); expect(balanced.results.length).toBeLessThan(creative.results.length);
    expect(safe.results.every(r => r.inputs[0]!.kind === "swap" && r.inputs[0]!.seed === "later")).toBe(true);
    const bounded = previewGuidedNames({ ...emptyGuidedUi(), mode: "blend", words: words(...Array.from({ length: 300 }, (_, i) => `word${i}`)) });
    expect(bounded.results.length).toBeLessThanOrEqual(300); expect(bounded.truncated).toBe(true);
  });
});
describe("guided Names retention and recovery", () => {
  it("atomically retains replayable history, independent favorite/save and immutable source context", () => {
    const { store, raw } = fixture(); store.updateContext({ description: "Original browser brief" }); store.addManual("Mikael");
    const source = structuredClone(store.getSnapshot().data.candidates[0]!);
    store.useAsSeed(source.source.id); store.updateContext({ description: "New brief" });
    const result = previewGuidedNames({ ...store.getSnapshot().data.ui.guided!, tweaks: ["reverse", "double_last"] }).results[0]!;
    expect(store.retainGuidedResult(result).ok).toBe(true);
    const kept = store.getSnapshot().data.candidates.at(-1)!;
    expect(kept.source.value).toBe("Leakimm"); expect(kept.favorite).toBe(true); expect(kept.saved).toBe(false);
    expect(kept.context).toEqual(source.context); expect(kept.source.history).toHaveLength(2);
    expect(namingSourceSchema.safeParse(kept.source).success).toBe(true);
    expect(namesWorkspaceSchema.safeParse(JSON.parse(raw()!)).success).toBe(true);
    expect(store.retainGuidedResult(result).ok).toBe(true); expect(store.getSnapshot().data.candidates).toHaveLength(3);
    expect(store.getSnapshot().data.candidates.at(-1)!.favorite).toBe(false);
    expect(store.getSnapshot().data.candidates[0]).toEqual(source);
  });
  it("rejects tampered recipes and missing roots without partial runs or names", () => {
    const { store, raw } = fixture();
    const result = previewGuidedNames({ ...emptyGuidedUi(), words: words("Mikael"), tweaks: ["reverse", "double_last"] }).results[0]!;
    expect(store.retainGuidedResult({ ...result, value: "invented" }).ok).toBe(false);
    expect(store.retainGuidedResult({ ...result, seed: { ...result.seed, candidateId: randomUUID() } }).ok).toBe(false);
    expect(store.getSnapshot().data.candidates).toEqual([]); expect(store.getSnapshot().data.runs).toEqual([]); expect(raw()).toBeNull();
  });
  it("loads old workspaces, restores saved words/context and rejects dangling source references", () => {
    const old = createEmptyNamesWorkspace(); const { store, replaceRaw } = fixture(); replaceRaw(JSON.stringify(old)); store.loadSaved();
    expect(store.getSnapshot().storage).toBe("available");
    const list = { id: randomUUID(), words: words("restored"), context: old.ui.context, createdAt: new Date().toISOString() };
    store.updateUi({ guided: { ...emptyGuidedUi(), savedLists: [list] } });
    expect(store.useGuidedWordList(list.id).ok).toBe(true); expect(store.getSnapshot().data.ui.guided!.words).toEqual(list.words);
    expect(store.updateUi({ guided: { ...emptyGuidedUi(), words: [{ value: "missing", candidateId: randomUUID() }] } }).ok).toBe(false);
  });
  it("preserves the durable branch on a cross-tab conflict while retaining this tab's exact new result", () => {
    const { store, raw, replaceRaw } = fixture(); store.addManual("original");
    const durable = JSON.parse(raw()!); durable.revision++; durable.ui.query = "other tab"; replaceRaw(JSON.stringify(durable));
    const result = previewGuidedNames({ ...emptyGuidedUi(), words: words("new"), prefixes: ["Neo"] }).results[0]!;
    expect(store.retainGuidedResult(result)).toMatchObject({ ok: true, persisted: false });
    expect(store.getSnapshot().storage).toBe("conflict"); expect(store.getSnapshot().data.candidates.at(-1)!.source.value).toBe("Neonew");
    expect(JSON.parse(raw()!).candidates).toHaveLength(1);
  });
  it("rejects an oversized atomic chain without pruning history or adding a partial result", () => {
    const { store, raw } = fixture();
    for (let i = 0; i < 99; i++) { const input: NameTransformInput = { kind: "swap", seed: "base", find: "base", replacement: `name${i}`, match: "first" }; expect(store.retainGuidedResult({ value: `name${i}`, origin: "base", seed: words("base")[0]!, inputs: [input] }).ok).toBe(true); }
    const before = raw();
    const result = previewGuidedNames({ ...emptyGuidedUi(), words: words("Mikael"), tweaks: ["reverse", "double_last"] }).results[0]!;
    expect(store.retainGuidedResult(result).ok).toBe(false); expect(raw()).toBe(before); expect(store.getSnapshot().data.runs).toHaveLength(99);
  });
});
