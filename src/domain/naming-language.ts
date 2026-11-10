import { initialNamingPreferencesV2 } from "./naming-brain-preferences";
/** Conservative, deterministic language defaults. Explicit naming requests win;
 * short/mixed/unsupported prose keeps the project's existing locale. */
const languages: [string, string][] = [
  ["en", "english|anglais"],
  ["fr", "french|français|francais"],
  ["es", "spanish|espagnol|español"],
  ["de", "german|allemand|deutsch"],
  ["it", "italian|italien|italiano"],
  ["pt", "portuguese|portugais|português"],
  ["ja", "japanese|japonais"],
  ["ko", "korean|coréen"],
  ["zh", "chinese|chinois"],
  ["ar", "arabic|arabe"],
];
export function explicitNamingLanguage(text: string): string | null {
  let latest: { index: number; locale: string } | null = null;
  for (const [locale, words] of languages) {
    const patterns = [
      new RegExp(`\\b(?:noms?)\\s+(${words})\\b`, "giu"),
      new RegExp(`\\b(?:names?|noms?)\\s+(?:in|en)\\s+(${words})\\b`, "giu"),
      new RegExp(
        `\\b(?:want|prefer|generate|suggest|cherche|veux|souhaite|génère|propose)\\s+(?:(?:des|de|the|some|only|uniquement)\\s+)?(${words})\\s+(?:names?|noms?)\\b`,
        "giu",
      ),
    ];
    for (const pattern of patterns)
      for (const match of text.matchAll(pattern)) {
        const index = match.index;
        if (/\b(?:not|no|never|pas|sans)\b[^,;.!?\n]{0,35}$/iu.test(text.slice(Math.max(0, index - 48), index)))
          continue;
        if (!latest || index > latest.index) latest = { index, locale };
      }
  }
  return latest?.locale ?? null;
}
export function inferNamingLanguage(messages: readonly string[], fallback: string): string {
  for (const message of [...messages].reverse()) {
    const explicit = explicitNamingLanguage(message);
    if (explicit) return explicit;
  }
  const words =
    messages
      .join(" ")
      .toLocaleLowerCase()
      .match(/[\p{L}]+/gu) ?? [];
  const fr = new Set([
    "je",
    "une",
    "des",
    "pour",
    "avec",
    "dans",
    "nous",
    "notre",
    "entreprise",
    "marque",
    "souhaite",
    "créer",
    "aider",
    "les",
    "qui",
    "est",
  ]);
  const en = new Set([
    "the",
    "with",
    "for",
    "want",
    "create",
    "our",
    "we",
    "that",
    "this",
    "business",
    "brand",
    "help",
    "and",
    "is",
    "are",
  ]);
  const scores = { fr: words.filter((word) => fr.has(word)).length, en: words.filter((word) => en.has(word)).length };
  if (scores.fr >= 3 && scores.fr > scores.en * 1.5) return "fr";
  if (scores.en >= 3 && scores.en > scores.fr * 1.5) return "en";
  return fallback;
}

/** UI defaults only. Keep the worker-attested readiness leaf byte-for-byte stable. */
export function initialInferredNamingPreferences(context: {
  creativeLocale: string;
  description?: string;
  intake: { namingNotes: string; conversation?: readonly { kind: string; text?: string }[] };
}) {
  const creativeLocale = inferNamingLanguage(
    [
      context.description ?? "",
      ...(context.intake.conversation ?? [])
        .filter((event) => event.kind === "user_message")
        .map((event) => event.text ?? ""),
      context.intake.namingNotes,
    ],
    context.creativeLocale,
  );
  return initialNamingPreferencesV2({ ...context, creativeLocale });
}
