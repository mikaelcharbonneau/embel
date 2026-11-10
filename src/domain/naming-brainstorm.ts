import { z } from "zod";
import { nameValueSchema } from "./naming";
import {
  matchesNamingTextFragment,
  namingApproachSchema,
  type NamingApproach,
  type NamingPreferencesV2,
} from "./naming-brain-preferences";

export const NAMING_BRAINSTORM_CAUTION = "Unchecked brainstorm. Research and screening are needed before use.";
const safeText = z
  .string()
  .trim()
  .min(1)
  .max(600)
  .refine(
    (value) =>
      !/[\p{Cc}\p{Bidi_Control}]/u.test(value) &&
      /[^\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Mark}\u2800]/u.test(value),
  );
export const namingBrainstormCandidateSchema = z.strictObject({
  value: nameValueSchema,
  rationale: safeText,
  primaryApproach: namingApproachSchema,
});
export type NamingBrainstormCandidate = z.infer<typeof namingBrainstormCandidateSchema>;
const constructedCandidate = namingBrainstormCandidateSchema.extend({
  construction: z.array(z.string().trim().min(1).max(100)).max(12),
});
type ConstructedCandidate = z.infer<typeof constructedCandidate>;
export const namingBrainstormAcceptedCandidateSchema = namingBrainstormCandidateSchema.extend({
  identityKey: z.string().min(1).max(320),
  caution: z.literal(NAMING_BRAINSTORM_CAUTION),
  graphemeCount: z.number().int().min(1).max(100),
});
export type NamingBrainstormAcceptedCandidate = z.infer<typeof namingBrainstormAcceptedCandidateSchema>;
export const namingBrainstormOutputSchema = z.strictObject({ candidates: z.array(z.unknown()).max(120) });
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
/** Matches the established project-name identity exactly, including retained symbols. */
export function namingBrainstormIdentity(value: string): string {
  return nameValueSchema
    .parse(value)
    .toLowerCase()
    .replace(/[\p{P}\s]/gu, "")
    .normalize("NFC");
}
export type ApproachSlot = { approach: NamingApproach; admit: number; request: number };
/** Spend each remaining position on the least represented selected approach.
 * Prior rows are admission evidence; SQL alone determines the saved total. */
export function allocateBrainstormApproaches(
  approaches: readonly NamingApproach[],
  prior: readonly NamingApproach[],
  remaining: number,
  candidateTarget: number,
): ApproachSlot[] {
  if (!approaches.length) throw Error("naming_brainstorm_approaches_required");
  const slots = approaches.map((approach) => ({
    approach,
    previous: prior.filter((value) => value === approach).length,
    admit: 0,
    request: 0,
  }));
  for (let i = 0; i < remaining; i++) {
    const next = slots.reduce((a, b) => (b.previous + b.admit < a.previous + a.admit ? b : a));
    next.admit++;
  }
  const open = slots.filter((row) => row.admit > 0);
  // Apportion the bounded provider request, including replacement proposals,
  // according to the remaining positions. No proposal is requested for a full route.
  for (let i = 0; i < candidateTarget && open.length; i++) {
    const next = open.reduce((a, b) => (b.request / b.admit < a.request / a.admit ? b : a));
    next.request++;
  }
  return open.map(({ approach, admit, request }) => ({ approach, admit, request }));
}
const fold = (text: string) => text.toLowerCase().normalize("NFC");
const visiblyJoined = (text: string) => /[\p{L}\p{N}][\s\p{Pd}_/&+]+[\p{L}\p{N}]|\p{Ll}\p{Lu}\p{Ll}/u.test(text);
// Compare citations without changing the name or evidence that gets saved.
// Fold punctuation and Latin accents for matching. Preserve marks in other scripts.
function referenceWords(text: string): string[] {
  return (
    fold(text)
      .normalize("NFD")
      .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
      .normalize("NFC")
      .match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) ?? []
  );
}
function containsPhrase(haystack: readonly string[], needle: readonly string[]): boolean {
  return needle.length > 0 && haystack.some((_, start) => needle.every((word, i) => word === haystack[start + i]));
}
function hasSourceReference(candidate: ConstructedCandidate): boolean {
  const name = referenceWords(candidate.value),
    rationale = referenceWords(candidate.rationale);
  const notes = new Set([...name, ...rationale]);
  return candidate.construction.some((raw) => {
    // Earlier responses sometimes annotate a source as "sora (Japanese)" or
    // "Ariadne's thread in Greek mythology". Its name and attribution can be
    // across both fields. A category word alone is not an identifiable source.
    const source = referenceWords(raw.replace(/\s*\([^()]*\)\s*$/u, ""));
    if (!source.length || !name.length) return false;
    const meaningful = source.filter(
      (word) =>
        !/^(?:a|an|the|or|of|for|in|from|and|by|s|myth|myths|mythology|story|stories|folklore|character|legend|literature|greek|classical|root)$/u.test(
          word,
        ),
    );
    if (!meaningful.length) return false;
    const named = containsPhrase(source, name) && meaningful.some((word) => name.includes(word));
    // A newly combined pair cannot pass as a named place or a literary allusion.
    if (visiblyJoined(candidate.value) && !named) return false;
    const literalTitle =
      named &&
      name.length > 1 &&
      (/^(?:the|a|an)$/u.test(name[0]!) ||
        /\b(?:film|franchise|series|novel|book|trilogy|game|movie|television)\b/iu.test(candidate.rationale));
    if (candidate.primaryApproach === "stories_culture" && literalTitle) return false;
    return named || containsPhrase(rationale, source) || meaningful.every((word) => notes.has(word));
  });
}
function constructionFits(candidate: ConstructedCandidate): boolean {
  const { value, primaryApproach: route, construction: sources } = candidate;
  const name = fold(value),
    words = sources.map(fold),
    single = !visiblyJoined(value);
  switch (route) {
    case "blends": {
      if (
        !/^[\p{L}\p{M}\p{N}]+$/u.test(value) ||
        words.length !== 2 ||
        words[0] === words[1] ||
        sources.some(visiblyJoined)
      )
        return false;
      const [left, right] = words;
      // The seam check below proves both words contribute; the rationale may
      // paraphrase them ("flirtation", "sincerity"), so it is not required to quote them.
      if (words.includes(name) || name === left! + right! || name === right! + left!) return false;
      const letters = Array.from(name);
      // A natural blend can use an interior fragment, two beginnings, or an
      // overlapping seam. Both ingredients must contribute recognizable text.
      for (let cut = 2; cut <= letters.length - 2; cut++) {
        const head = letters.slice(0, cut).join(""),
          tail = letters.slice(cut).join("");
        if (left!.includes(head) && right!.includes(tail)) return true;
      }
      return false;
    }
    case "compounds":
      return words.length >= 2 && !sources.some(visiblyJoined) && namingBrainstormIdentity(value) === words.join("");
    case "phrases":
      return (
        words.length >= 2 &&
        (visiblyJoined(value) ||
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(
            value,
          )) &&
        namingBrainstormIdentity(value) === words.join("")
      );
    case "initials":
      return (
        words.length >= 2 &&
        !sources.some(visiblyJoined) &&
        namingBrainstormIdentity(value) === words.map((w) => Array.from(w)[0]).join("")
      );
    case "invented":
      return single && words.length === 0;
    case "modified": {
      const base = words[0];
      if (
        !single ||
        words.length !== 1 ||
        !base ||
        visiblyJoined(sources[0]!) ||
        name === base ||
        !fold(candidate.rationale).includes(base)
      )
        return false;
      return (
        base.includes(name) ||
        name.includes(base) ||
        name.slice(0, 2) === base.slice(0, 2) ||
        name.slice(-2) === base.slice(-2)
      );
    }
    case "real_words":
      return single && words.length === 1 && name === words[0];
    default:
      return hasSourceReference(candidate);
  }
}
/** Historical calls keep their original format. New calls also enforce their
 * construction and per-approach limits, without rewriting provider evidence.
 * Balanced calls admit each approach's share. On the final call (`finalFill`),
 * valid names beyond an approach's share then fill the places still open, so a
 * set is not left short only because one approach under-delivered. */
export function filterNamingBrainstormCandidates(
  raw: readonly unknown[],
  preferences: NamingPreferencesV2,
  excludedIdentities: readonly string[],
  remaining = 100,
  slots?: readonly ApproachSlot[],
  finalFill = false,
): NamingBrainstormAcceptedCandidate[] {
  const seen = new Set(excludedIdentities),
    accepted: NamingBrainstormAcceptedCandidate[] = [];
  const room = slots && new Map(slots.map(({ approach, admit }) => [approach, admit]));
  const limit = Math.max(0, Math.min(100, remaining)),
    overflow: unknown[] = [];
  const admit = (item: unknown, balanced: boolean) => {
    let source = item;
    if (room) {
      const parsed = constructedCandidate.safeParse(item);
      if (!parsed.success || !constructionFits(parsed.data)) return;
      if (balanced && !room.get(parsed.data.primaryApproach)) {
        overflow.push(item);
        return;
      }
      const { value, rationale, primaryApproach } = parsed.data;
      source = { value, rationale, primaryApproach };
    }
    const parsed = namingBrainstormCandidateSchema.safeParse(source);
    if (!parsed.success) return;
    const candidate = parsed.data,
      identityKey = namingBrainstormIdentity(candidate.value);
    const graphemeCount = Array.from(segmenter.segment(candidate.value)).length;
    if (
      !identityKey ||
      seen.has(identityKey) ||
      !preferences.approaches.includes(candidate.primaryApproach) ||
      graphemeCount > 100 ||
      (preferences.minimumGraphemes !== null && graphemeCount < preferences.minimumGraphemes) ||
      (preferences.maximumGraphemes !== null && graphemeCount > preferences.maximumGraphemes) ||
      preferences.requiredText.some((text) => !matchesNamingTextFragment(candidate.value, text)) ||
      preferences.excludedText.some((text) => matchesNamingTextFragment(candidate.value, text))
    )
      return;
    seen.add(identityKey);
    if (room && balanced) room.set(candidate.primaryApproach, room.get(candidate.primaryApproach)! - 1);
    accepted.push({ ...candidate, identityKey, graphemeCount, caution: NAMING_BRAINSTORM_CAUTION });
  };
  for (const item of raw.slice(0, 120)) {
    if (accepted.length >= limit) break;
    admit(item, true);
  }
  if (room && finalFill)
    for (const item of overflow) {
      if (accepted.length >= limit) break;
      admit(item, false);
    }
  return accepted;
}
