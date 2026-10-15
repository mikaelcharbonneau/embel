import { z } from "zod";
import { nameValueSchema, type NameTransformInput } from "./naming";
import { contextSnapshotSchema } from "./projects";

export const guidedTweakIds = ["reverse", "drop_vowel", "strip_vowels", "stutter", "pig_latin", "inner_reverse", "vowel_shift", "mirror", "double_last", "alternate_case"] as const;
export type GuidedTweak = typeof guidedTweakIds[number];
const wordSchema = z.strictObject({ value: nameValueSchema, candidateId: z.uuid().nullable() });
export const guidedUiSchema = z.strictObject({
  words: z.array(wordSchema).max(300), draft: z.string().max(3000),
  mode: z.enum(["affixes", "tweaks", "blend", "swap"]),
  prefixes: z.array(nameValueSchema).max(40), suffixes: z.array(nameValueSchema).max(40),
  customPrefixes: z.array(z.string().max(160)).min(1).max(12), customSuffixes: z.array(z.string().max(160)).min(1).max(12),
  tweaks: z.array(z.enum(guidedTweakIds)).max(10).refine(values => new Set(values).size === values.length),
  swapLevel: z.enum(["safe", "balanced", "creative"]),
  savedLists: z.array(z.strictObject({ id: z.uuid(), words: z.array(wordSchema).min(1).max(300), context: contextSnapshotSchema, createdAt: z.iso.datetime({ offset: true }) })).max(20),
}).refine(ui => new Set(ui.words.map(word => word.value)).size === ui.words.length, "Remove duplicate words");
export type GuidedUi = z.infer<typeof guidedUiSchema>;
export type GuidedResult = { value: string; origin: string; seed: GuidedUi["words"][number]; inputs: NameTransformInput[] };
export const emptyGuidedUi = (): GuidedUi => ({ words: [], draft: "", mode: "affixes", prefixes: [], suffixes: [], customPrefixes: [""], customSuffixes: [""], tweaks: [], swapLevel: "balanced", savedLists: [] });
