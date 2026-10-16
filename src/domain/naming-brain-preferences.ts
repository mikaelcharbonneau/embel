import { z } from "zod";

/** Shared leaf: importing these preferences never imports project or server modules. */
export const NAMING_APPROACHES = [
  { id: "real_words", label: "Real words", description: "Familiar words used in unexpected ways.", examples: ["Apple", "BlackBerry", "Jaguar"] },
  { id: "compounds", label: "Compounds", description: "Complete words joined through meaning, contrast, and rhythm.", examples: [] },
  { id: "blends", label: "Blended words", description: "Word fragments combined into new forms.", examples: [] },
  { id: "invented", label: "Invented words", description: "New forms explored through sound, stress, and rhythm.", examples: [] },
  { id: "modified", label: "Modified words", description: "Intentional alterations, extensions, and shortened forms.", examples: [] },
  { id: "phrases", label: "Phrases", description: "Short expressions and unexpected pairings.", examples: [] },
  { id: "initials", label: "Initials & acronyms", description: "Abbreviations of proposed meaningful expressions.", examples: [] },
  { id: "other_languages", label: "Other languages", description: "Sourced words, translations, and adaptations.", examples: [] },
  { id: "classical_roots", label: "Classical roots", description: "Verified historical roots and original constructions.", examples: [] },
  { id: "people_places", label: "People & places", description: "Heritage, places, and symbolic associations.", examples: [] },
  { id: "stories_culture", label: "Stories & culture", description: "Grounded allusions to literature, stories, and culture.", examples: [] },
] as const;
export const namingApproachSchema = z.enum(["real_words", "compounds", "blends", "invented", "modified", "phrases", "initials", "other_languages", "classical_roots", "people_places", "stories_culture"]);
export type NamingApproach = z.infer<typeof namingApproachSchema>;
export const namingDirectnessSchema = z.enum(["direct", "suggestive", "open_ended", "all"]);
export type NamingDirectness = z.infer<typeof namingDirectnessSchema>;

const fragmentSchema = z.string().trim().min(1).max(160).refine(value => !/[\p{Cc}\p{Bidi_Control}]/u.test(value), "Text fragments cannot contain controls");
const fragmentsSchema = z.array(fragmentSchema).max(20).refine(values => new Set(values.map(normalizeNamingText)).size === values.length, "Text fragments must be distinct");
export const namingPreferencesV2Schema = z.strictObject({
  version: z.literal(2), creativeLocale: z.string().trim().min(2).max(30), notes: z.string().trim().max(2000),
  minimumGraphemes: z.number().int().min(1).max(160).nullable(), maximumGraphemes: z.number().int().min(1).max(160).nullable(),
  approaches: z.array(namingApproachSchema).max(11).refine(values => new Set(values).size === values.length, "Approaches must be unique"),
  directness: namingDirectnessSchema.nullable(), sourceLanguages: z.array(z.string().trim().min(2).max(80)).max(12).refine(values => new Set(values.map(normalizeNamingText)).size === values.length, "Source languages must be distinct"),
  heritageNotes: z.string().trim().max(2000), culturalNotes: z.string().trim().max(2000), requiredText: fragmentsSchema, excludedText: fragmentsSchema,
}).refine(value => value.minimumGraphemes === null || value.maximumGraphemes === null || value.minimumGraphemes <= value.maximumGraphemes,
  { message: "Minimum length must not exceed maximum length", path: ["minimumGraphemes"] });
export type NamingPreferencesV2 = z.infer<typeof namingPreferencesV2Schema>;

function normalizeNamingText(value: string): string { return value.normalize("NFC").toLowerCase().normalize("NFC"); }
/** Text fragments intentionally preserve punctuation and accents; no fuzzy or identity matching. */
export function matchesNamingTextFragment(value: string, fragment: string): boolean {
  return normalizeNamingText(value).includes(normalizeNamingText(fragmentSchema.parse(fragment)));
}

/** Explicit empty cards; reading an older preference never manufactures an answer. */
export function initialNamingPreferencesV2(context: { creativeLocale: string; intake: { namingNotes: string } }): NamingPreferencesV2 {
  return namingPreferencesV2Schema.parse({ version: 2, creativeLocale: context.creativeLocale, notes: context.intake.namingNotes, minimumGraphemes: null, maximumGraphemes: null, approaches: [], directness: null, sourceLanguages: [], heritageNotes: "", culturalNotes: "", requiredText: [], excludedText: [] });
}

export function getNamingPreferencesReadiness(preferences: NamingPreferencesV2): { ready: boolean; missing: ("approaches" | "directness" | "conflicting_text" | "impossible_length")[] } {
  const value = namingPreferencesV2Schema.parse(preferences);
  const missing: ReturnType<typeof getNamingPreferencesReadiness>["missing"] = [];
  if (!value.approaches.length) missing.push("approaches");
  if (!value.directness) missing.push("directness");
  if (value.requiredText.some(required => value.excludedText.some(excluded => matchesNamingTextFragment(required, excluded)))) missing.push("conflicting_text");
  if (value.maximumGraphemes !== null && value.requiredText.some(fragment => /^[\x20-\x7e]+$/.test(fragment) && fragment.length > value.maximumGraphemes!)) missing.push("impossible_length");
  return { ready: missing.length === 0, missing };
}
