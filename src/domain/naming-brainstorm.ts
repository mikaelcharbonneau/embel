import { z } from "zod";
import { nameValueSchema } from "./naming";
import { matchesNamingTextFragment, namingApproachSchema, type NamingPreferencesV2 } from "./naming-brain-preferences";

export const NAMING_BRAINSTORM_PROFILE = "brainstorm_v1" as const;
export const NAMING_BRAINSTORM_TARGET = 100;
export const NAMING_BRAINSTORM_MAX_CALLS = 3;
export const NAMING_BRAINSTORM_CAUTION = "Unchecked brainstorm. Research and screening are needed before use.";
const safeText = z.string().trim().min(1).max(600).refine(value => !/[\p{Cc}\p{Bidi_Control}]/u.test(value) && /[^\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Mark}\u2800]/u.test(value));
export const namingBrainstormCandidateSchema = z.strictObject({ value: nameValueSchema, rationale: safeText, primaryApproach: namingApproachSchema });
export type NamingBrainstormCandidate = z.infer<typeof namingBrainstormCandidateSchema>;
export const namingBrainstormAcceptedCandidateSchema = namingBrainstormCandidateSchema.extend({ identityKey: z.string().min(1).max(320), caution: z.literal(NAMING_BRAINSTORM_CAUTION), graphemeCount: z.number().int().min(1).max(100) });
export type NamingBrainstormAcceptedCandidate = z.infer<typeof namingBrainstormAcceptedCandidateSchema>;
export const namingBrainstormOutputSchema = z.strictObject({ candidates: z.array(z.unknown()).max(120) });
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
/** Matches the established project-name identity exactly, including retained symbols. */
export function namingBrainstormIdentity(value: string): string { return nameValueSchema.parse(value).toLowerCase().replace(/[\p{P}\s]/gu, "").normalize("NFC"); }
/** A deterministic admission pass; creative labels and rationales remain unchecked. */
export function filterNamingBrainstormCandidates(raw: readonly unknown[], preferences: NamingPreferencesV2, excludedIdentities: readonly string[], remaining = 100): NamingBrainstormAcceptedCandidate[] {
  const seen = new Set(excludedIdentities), accepted: NamingBrainstormAcceptedCandidate[] = [];
  for (const item of raw.slice(0, 120)) {
    if (accepted.length >= Math.max(0, Math.min(100, remaining))) break;
    const parsed = namingBrainstormCandidateSchema.safeParse(item); if (!parsed.success) continue;
    const candidate = parsed.data, identityKey = namingBrainstormIdentity(candidate.value);
    const graphemeCount = Array.from(segmenter.segment(candidate.value)).length;
    if (!identityKey || seen.has(identityKey) || !preferences.approaches.includes(candidate.primaryApproach) || graphemeCount > 100
      || preferences.minimumGraphemes !== null && graphemeCount < preferences.minimumGraphemes
      || preferences.maximumGraphemes !== null && graphemeCount > preferences.maximumGraphemes
      || preferences.requiredText.some(text => !matchesNamingTextFragment(candidate.value, text))
      || preferences.excludedText.some(text => matchesNamingTextFragment(candidate.value, text))) continue;
    seen.add(identityKey);
    accepted.push({ ...candidate, identityKey, graphemeCount, caution: NAMING_BRAINSTORM_CAUTION });
  }
  return accepted;
}
export const namingBrainstormResponseIdSchema = z.string().regex(/^resp_[A-Za-z0-9_-]{1,194}$/u);
export const namingBrainstormRequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
export const namingBrainstormWireSchema = z.strictObject({
  model: z.string().min(1).max(150), store: z.literal(true), stream: z.literal(true), reasoning: z.strictObject({ effort: z.literal("low") }),
  max_output_tokens: z.literal(16000), input: z.string().min(1).max(125_000),
  text: z.strictObject({ verbosity: z.literal("low"), format: z.strictObject({ type: z.literal("json_schema"), name: z.literal("naming_brainstorm_v1"), strict: z.literal(true), schema: z.json() }) }),
  metadata: z.strictObject({ embel_generation_profile: z.literal(NAMING_BRAINSTORM_PROFILE), embel_job_id: z.uuid(), embel_run_id: z.uuid(), embel_call_index: z.enum(["1", "2", "3"]) }),
}).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 131_072);
export type NamingBrainstormWire = z.infer<typeof namingBrainstormWireSchema>;
export const namingBrainstormUsageSchema = z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative() }).catchall(z.json());
