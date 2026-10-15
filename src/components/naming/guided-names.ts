import { nameValueSchema, transformNames, type NameTransformInput } from "@/domain/naming";
import { guidedUiSchema, type GuidedUi, type GuidedResult, type GuidedTweak } from "@/domain/names-guided";
export { guidedUiSchema, emptyGuidedUi, guidedTweakIds } from "@/domain/names-guided";
export type { GuidedUi, GuidedResult, GuidedTweak } from "@/domain/names-guided";

export const prefixChoices = "Any Base Clear Co Core Crea Evo Fine Free Glow Good Grow Hyper Max Meta Neo Nex New Open Ori Para Pre Prime Pro Re Ray Sol Smart Super Think True Ultra Up Van".split(" ");
export const suffixChoices = "able al ana ary ella er ful ia ic ify io ish ism ist ity ium iva ix less ly ment ness ora ory ous ova sy ure verse ville wise works".split(" ");
export const tweakChoices = [
  { id: "reverse", label: "Reverse", icon: "arrow-left-right", description: "Flip every letter.", example: "Mikael → Leakim" },
  { id: "drop_vowel", label: "Drop last vowel", icon: "scissors", description: "Cut the final vowel, y included.", example: "later → latr" },
  { id: "strip_vowels", label: "Strip vowels", icon: "eraser", description: "Leave only the consonants.", example: "Mikael → Mkl" },
  { id: "stutter", label: "Stutter", icon: "repeat-2", description: "Repeat the opening of the word.", example: "Mikael → Mi-Mikael" },
  { id: "pig_latin", label: "Pig Latin", icon: "languages", description: "Move the opening consonants and add ay.", example: "Mikael → Ikaelmay" },
  { id: "inner_reverse", label: "Inner reverse", icon: "arrow-right-left", description: "Flip the middle and keep both ends.", example: "Mikael → Meakil" },
  { id: "vowel_shift", label: "Vowel shift", icon: "case-sensitive", description: "Step vowels forward along a, e, i, o, u.", example: "later → letir" },
  { id: "mirror", label: "Mirror", icon: "columns-2", description: "Stretch the word into a palindrome.", example: "Mikael → Mikaeleakim" },
  { id: "double_last", label: "Double last", icon: "copy-plus", description: "Repeat the final letter.", example: "later → laterr" },
  { id: "alternate_case", label: "Alternate case", icon: "case-upper", description: "Swap case on every other letter.", example: "Mikael → MiKaEl" },
] as const;
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const letters = (text: string) => [...segmenter.segment(text)].map(item => item.segment);
const vowel = (text: string) => /^[aeiouy]$/iu.test(text.normalize("NFD").replace(/\p{M}/gu, ""));
const sameCase = (original: string, next: string) => original !== original.toLowerCase() ? next.toUpperCase() : next;
// Preserve the original case pattern across permutations; explicit alternate case is separate.
const recase = (original: string, output: string) => /^[\p{Lu}][\p{Ll}\p{M}]+$/u.test(original) ? letters(output.toLowerCase()).map((c, i) => i === 0 ? c.toUpperCase() : c).join("") : output;
export function applyGuidedTweak(value: string, tweak: GuidedTweak): string {
  const chars = letters(value);
  switch (tweak) {
    case "reverse": return recase(value, [...chars].reverse().join(""));
    case "drop_vowel": { let index = -1; chars.forEach((c, i) => { if (vowel(c)) index = i; }); return chars.filter((_, i) => i !== index).join(""); }
    case "strip_vowels": return chars.filter(c => !vowel(c)).join("");
    case "stutter": return `${chars.slice(0, 2).join("")}-${value}`;
    case "pig_latin": { const index = chars.findIndex(vowel); return index <= 0 ? `${value}ay` : recase(value, chars.slice(index).join("") + chars.slice(0, index).join("") + "ay"); }
    case "inner_reverse": return recase(value, chars.length > 2 ? chars[0] + chars.slice(1, -1).reverse().join("") + chars.at(-1) : value);
    case "vowel_shift": return chars.map(c => { const index = "aeiou".indexOf(c.toLowerCase()); return index < 0 ? c : sameCase(c, "eioua"[index]!); }).join("");
    case "mirror": return value + chars.slice(0, -1).reverse().join("").toLowerCase();
    case "double_last": return value + (chars.at(-1) ?? "");
    case "alternate_case": return chars.map((c, i) => i % 2 ? c.toLowerCase() : c.toUpperCase()).join("");
  }
}
export function addGuidedWords(ui: GuidedUi): GuidedUi {
  const added = ui.draft.split(/[,\n]/u).map(value => value.trim()).filter(Boolean).map(value => ({ value: nameValueSchema.parse(value), candidateId: null }));
  const words = new Map(ui.words.map(word => [word.value, word]));
  for (const word of added) if (!words.has(word.value)) words.set(word.value, word);
  return guidedUiSchema.parse({ ...ui, draft: "", words: [...words.values()] });
}
function literal(seed: string, replacement: string): NameTransformInput { return { kind: "swap", seed, find: seed, replacement, match: "first" }; }
const swaps: Record<string, string[]> = { a: ["e", "o", "i"], e: ["i", "a", "u"], i: ["y", "e", "a"], o: ["u", "a", "e"], u: ["o", "i", "a"], y: ["i", "e"], b: ["p", "m"], p: ["b", "t"], t: ["d", "k"], d: ["t", "g"], c: ["k", "s"], k: ["c", "g"], g: ["k", "j"], f: ["v", "ph"], v: ["f", "b"], s: ["z", "c"], z: ["s", "x"], m: ["n", "b"], n: ["m", "ng"], r: ["l"], l: ["r"] };
/** Bounded live preview. Only an explicit favorite records replayable literal transformations. */
export function previewGuidedNames(ui: GuidedUi): { results: GuidedResult[]; truncated: boolean; omitted: number } {
  const results: GuidedResult[] = [], seen = new Set<string>();
  let truncated = false, omitted = 0, attempts = 0;
  function add(seed: GuidedResult["seed"], inputs: NameTransformInput[], origin = seed.value) {
    let value = seed.value;
    try { for (const input of inputs) { const output = transformNames(input).candidates; if (output.length !== 1) { omitted++; return; } value = output[0]!.value; } nameValueSchema.parse(value); }
    catch { omitted++; return; }
    if (seen.has(value)) return;
    seen.add(value);
    if (results.length >= 300) { truncated = true; return; }
    results.push({ value, seed, inputs, origin });
  }
  if (ui.mode === "blend") {
    // Pair order is stable; stop after the first excess unique result, before quadratic expansion.
    for (let i = 0; i < ui.words.length && !truncated; i++) for (let j = i + 1; j < ui.words.length && !truncated; j++) {
      for (const [left, right] of [[ui.words[i]!, ui.words[j]!], [ui.words[j]!, ui.words[i]!]] as const) {
        const cleanLeft = left.value.replace(/[^\p{L}\p{M}\p{N}]/gu, ""), cleanRight = right.value.replace(/[^\p{L}\p{M}\p{N}]/gu, "");
        const a = letters(cleanLeft), b = letters(cleanRight);
        if (!a.length || !b.length) continue;
        // At most 49 cuts per direction, independent of the 160-unit word bound.
        const cuts = (length: number) => [...new Set([1, 2, Math.floor(length / 3), Math.floor(length / 2), Math.ceil(length * 2 / 3), length - 1, length].filter(n => n > 0 && n <= length))];
        for (const take of cuts(a.length)) for (const drop of cuts(b.length).map(n => n - 1)) {
          if (truncated) break;
          if (++attempts > 6000) { truncated = true; break; }
          const prefix = a.slice(0, take), tail = b.slice(drop);
          let overlap = 0;
          for (let n = 1; n <= Math.min(prefix.length, tail.length); n++) if (prefix.slice(-n).join("").toLowerCase() === tail.slice(0, n).join("").toLowerCase()) overlap = n;
          const input: NameTransformInput = { kind: "blend", left: cleanLeft, right: cleanRight, leftTake: take, rightDrop: drop + overlap };
          const preparation = cleanLeft === left.value ? [] : [literal(left.value, cleanLeft)];
          const value = prefix.join("") + tail.slice(overlap).join("");
          if (value === cleanLeft || value === cleanRight) continue;
          add(left, [...preparation, input], `${left.value} + ${right.value}`);
        }
      }
    }
  } else if (ui.mode === "swap") {
    const variants = ui.swapLevel === "safe" ? 1 : ui.swapLevel === "balanced" ? 2 : 3;
    for (const word of ui.words) {
      if (truncated) break;
      const chars = letters(word.value);
      for (let i = 0; i < chars.length && !truncated; i++) for (const replacement of (swaps[chars[i]!.toLowerCase()] ?? []).slice(0, variants)) {
        const value = [...chars.slice(0, i), sameCase(chars[i]!, replacement), ...chars.slice(i + 1)].join("");
        add(word, [literal(word.value, value)]);
      }
    }
  } else {
    const affixes = [...new Set([...ui.prefixes, ...ui.customPrefixes.map(v => v.trim()).filter(Boolean)])].map(value => ({ prefix: value, suffix: "" })).concat([...new Set([...ui.suffixes, ...ui.customSuffixes.map(v => v.trim()).filter(Boolean)])].map(value => ({ prefix: "", suffix: value })));
    for (const word of ui.words) {
      if (truncated) break;
      for (const affix of (affixes.length ? affixes : [{ prefix: "", suffix: "" }])) {
        if (truncated) break;
        let value = word.value;
        const inputs: NameTransformInput[] = [];
        if (affix.prefix || affix.suffix) { inputs.push({ kind: "affixes", seed: value, prefixes: affix.prefix ? [affix.prefix] : [], suffixes: affix.suffix ? [affix.suffix] : [], separator: "" }); value = affix.prefix + value + affix.suffix; }
        for (const tweak of tweakChoices.filter(t => ui.tweaks.includes(t.id))) {
          const next = applyGuidedTweak(value, tweak.id);
          if (next !== value) { inputs.push(literal(value, next)); value = next; }
        }
        add(word, inputs);
      }
    }
  }
  return { results, truncated, omitted };
}
