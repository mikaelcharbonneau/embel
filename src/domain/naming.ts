import { z } from "zod";

const MAX_NAME_LENGTH = 160;
const MAX_RAW_LENGTH = 320;
const MAX_CANDIDATES = 64;
const MAX_HISTORY = 32;

// Retain joiners/variation selectors used by writing systems and emoji. Reject
// controls, line/paragraph separators, bidi controls, and unpaired surrogates.
const forbiddenText = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\p{Surrogate}]/u;
const invisibleOnly = /^[\s\p{Default_Ignorable_Code_Point}]*$/u;
const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter("en", { granularity: "word" });

function normalizedText(trim: boolean) {
  // Zod's string max counts code points in the installed version. The project
  // naming limit intentionally uses UTF-16 units, so check .length explicitly.
  return z
    .string()
    .refine((value) => value.length <= MAX_RAW_LENGTH, "Text exceeds the input limit")
    .refine((value) => !forbiddenText.test(value), "Remove control characters or invalid Unicode")
    .transform((value) => (trim ? value.normalize("NFC").trim() : value.normalize("NFC")))
    .pipe(z.string().refine((value) => value.length <= MAX_NAME_LENGTH, "Use at most 160 UTF-16 code units"));
}

/** NFC and outer whitespace normalization; the saved value is at most 160 UTF-16 units. */
export const nameValueSchema = normalizedText(true).refine(
  (value) => !invisibleOnly.test(value),
  "Enter a nonempty, visible name",
);
const affixSchema = normalizedText(true).refine(
  (value) => value === "" || !invisibleOnly.test(value),
  "Use a visible affix or leave it empty",
);

function graphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), (item) => item.segment);
}

const affixesInputSchema = z
  .strictObject({
    kind: z.literal("affixes"),
    seed: nameValueSchema,
    prefixes: z.array(affixSchema).max(12),
    suffixes: z.array(affixSchema).max(12),
    separator: z.enum(["", " ", "-"]),
  })
  .refine((input) => [...input.prefixes, ...input.suffixes].some((value) => value !== ""), {
    message: "Add at least one prefix or suffix",
    path: ["prefixes"],
  });

const tweakOperationSchema = z.enum(["lowercase", "uppercase", "titlecase", "remove_spaces", "hyphenate"]);
const tweaksInputSchema = z.strictObject({
  kind: z.literal("tweaks"),
  seed: nameValueSchema,
  operations: z.array(tweakOperationSchema).min(1).max(5),
});

const blendInputSchema = z
  .strictObject({
    kind: z.literal("blend"),
    left: nameValueSchema,
    right: nameValueSchema,
    leftTake: z.number().int().min(1).max(MAX_NAME_LENGTH),
    rightDrop: z.number().int().min(0).max(MAX_NAME_LENGTH),
  })
  .superRefine((input, ctx) => {
    if (input.leftTake > graphemes(input.left).length) {
      ctx.addIssue({ code: "custom", path: ["leftTake"], message: "Keep no more than the left name's grapheme count" });
    }
    if (input.rightDrop > graphemes(input.right).length) {
      ctx.addIssue({
        code: "custom",
        path: ["rightDrop"],
        message: "Drop no more than the right name's grapheme count",
      });
    }
  });

const swapInputSchema = z.strictObject({
  kind: z.literal("swap"),
  seed: nameValueSchema,
  // Spaces are significant in literal search/replacement, unlike name edges.
  find: normalizedText(false).refine((value) => value.length > 0, "Enter text to find"),
  replacement: normalizedText(false),
  match: z.enum(["first", "all"]),
});

export const nameTransformInputSchema = z.discriminatedUnion("kind", [
  affixesInputSchema,
  tweaksInputSchema,
  blendInputSchema,
  swapInputSchema,
]);
export type NameTransformInput = z.infer<typeof nameTransformInputSchema>;

type NameTransformResult = {
  candidates: Array<{ value: string; explanation: string }>;
  truncated: boolean;
  notes: string[];
};

function titlecase(value: string): string {
  // Fixed English word segmentation; Unicode default case mapping, not a
  // language-specific spelling correction. Uppercase the first letter cluster.
  return Array.from(wordSegmenter.segment(value), (word) => {
    if (!word.isWordLike) return word.segment;
    let firstLetter = true;
    return graphemes(word.segment.toLowerCase())
      .map((cluster) => {
        if (!firstLetter || !/\p{L}/u.test(cluster)) return cluster;
        firstLetter = false;
        return cluster.toUpperCase();
      })
      .join("");
  }).join("");
}

const tweakOperations: Record<
  z.infer<typeof tweakOperationSchema>,
  { apply: (value: string) => string; explanation: string }
> = {
  lowercase: { apply: (value) => value.toLowerCase(), explanation: "Applied Unicode lowercase mapping." },
  uppercase: { apply: (value) => value.toUpperCase(), explanation: "Applied Unicode uppercase mapping." },
  titlecase: {
    apply: titlecase,
    explanation: "Lowercased each word and uppercased its first letter cluster using English word boundaries.",
  },
  remove_spaces: { apply: (value) => value.replace(/\s+/gu, ""), explanation: "Removed whitespace." },
  hyphenate: {
    apply: (value) => value.replace(/\s+/gu, "-"),
    explanation: "Replaced each run of whitespace with a hyphen.",
  },
};

/**
 * Local deterministic text controls, with no availability or linguistic claims.
 * Affixes: prefix-major Cartesian product, empty sides supply one empty affix.
 * Tweaks: independent variants in requested order, never a chained operation.
 * Blend: keep leftTake graphemes, then append right after rightDrop graphemes.
 * Swap: case-sensitive literal, nonoverlapping matches on original text, only
 * at complete-grapheme boundaries. Replacement text has no template semantics.
 * Every result is NFC/trim normalized; unchanged/duplicate/empty/oversized
 * values are omitted with notes. At most the first 64 unique values are kept.
 * Segmentation follows the runtime's Unicode data using a fixed "en" locale.
 */
export function transformNames(input: NameTransformInput): NameTransformResult {
  const parsed = nameTransformInputSchema.parse(input);
  return transformParsedNames(parsed);
}

function transformParsedNames(input: NameTransformInput): NameTransformResult {
  const result: NameTransformResult = { candidates: [], truncated: false, notes: [] };
  const seen = new Set<string>();
  const seed = input.kind === "blend" ? input.left : input.seed;
  function note(message: string) {
    if (!result.notes.includes(message)) result.notes.push(message);
  }
  function add(raw: string, explanation: string) {
    const value = raw.normalize("NFC").trim();
    if (value.length > MAX_NAME_LENGTH) {
      note("Results over 160 UTF-16 code units were omitted.");
      return;
    }
    if (invisibleOnly.test(value)) {
      note("Empty or invisible results were omitted.");
      return;
    }
    if (value === seed) {
      note("Unchanged results were omitted.");
      return;
    }
    if (seen.has(value)) {
      note("Duplicate results were omitted.");
      return;
    }
    seen.add(value);
    if (result.candidates.length === MAX_CANDIDATES) {
      result.truncated = true;
      note("Only the first 64 unique results are shown.");
      return;
    }
    result.candidates.push({ value, explanation });
  }

  switch (input.kind) {
    case "affixes": {
      const prefixes = input.prefixes.length ? input.prefixes : [""];
      const suffixes = input.suffixes.length ? input.suffixes : [""];
      for (const prefix of prefixes) {
        for (const suffix of suffixes) {
          const details = [prefix ? `prefix “${prefix}”` : "", suffix ? `suffix “${suffix}”` : ""]
            .filter(Boolean)
            .join(" and ");
          add(
            [prefix, input.seed, suffix].filter((value) => value !== "").join(input.separator),
            `Added ${details || "no affix"}.`,
          );
        }
      }
      break;
    }
    case "tweaks": {
      for (const operation of input.operations) {
        const tweak = tweakOperations[operation];
        add(tweak.apply(input.seed), tweak.explanation);
      }
      break;
    }
    case "blend": {
      add(
        graphemes(input.left).slice(0, input.leftTake).join("") +
          graphemes(input.right).slice(input.rightDrop).join(""),
        `Kept ${input.leftTake} grapheme${input.leftTake === 1 ? "" : "s"} from the left and dropped ${input.rightDrop} from the right.`,
      );
      break;
    }
    case "swap": {
      const boundaries = new Set<number>([0, input.seed.length]);
      for (const part of graphemeSegmenter.segment(input.seed)) boundaries.add(part.index);
      const pieces: string[] = [];
      let searchAt = 0;
      let copyFrom = 0;
      let matches = 0;
      while (searchAt < input.seed.length) {
        const start = input.seed.indexOf(input.find, searchAt);
        if (start === -1) break;
        const end = start + input.find.length;
        if (!boundaries.has(start) || !boundaries.has(end)) {
          searchAt = start + 1;
          continue;
        }
        pieces.push(input.seed.slice(copyFrom, start), input.replacement);
        copyFrom = end;
        searchAt = end;
        matches += 1;
        if (input.match === "first") break;
      }
      if (!matches) {
        note("No complete-grapheme match was found.");
      } else {
        pieces.push(input.seed.slice(copyFrom));
        add(pieces.join(""), `Replaced ${matches} literal match${matches === 1 ? "" : "es"} of “${input.find}”.`);
      }
      break;
    }
  }
  return result;
}

const namingHistoryStepSchema = z.strictObject({
  id: z.uuid(),
  input: nameTransformInputSchema,
  output: nameValueSchema,
  createdAt: z.iso.datetime({ offset: true }),
});

/** Immutable local provenance of a chosen name, not evidence of provider work or ownership. */
export const namingSourceSchema = z
  .strictObject({
    id: z.uuid(),
    value: nameValueSchema,
    createdAt: z.iso.datetime({ offset: true }),
    origin: z.enum(["manual", "workshop"]),
    history: z.array(namingHistoryStepSchema).max(MAX_HISTORY),
  })
  .superRefine((source, ctx) => {
    if (source.origin === "manual" && source.history.length) {
      ctx.addIssue({ code: "custom", path: ["history"], message: "Manual names cannot have workshop history" });
    }
    if (source.origin === "workshop" && !source.history.length) {
      ctx.addIssue({ code: "custom", path: ["history"], message: "Workshop names require a chosen transformation" });
    }
    // Bound replay even for an already-invalid oversized history.
    if (source.history.length > MAX_HISTORY) return;
    const ids = new Set<string>();
    for (let index = 0; index < source.history.length; index += 1) {
      const step = source.history[index]!;
      if (ids.has(step.id)) {
        ctx.addIssue({ code: "custom", path: ["history", index, "id"], message: "History identifiers must be unique" });
      }
      ids.add(step.id);
      // Zod's continuable nested refinements can leave invalid work here. Never
      // replay it; the nested schema has already recorded the validation issues.
      const validInput = nameTransformInputSchema.safeParse(step.input);
      if (!validInput.success) continue;
      const previous = source.history[index - 1];
      const seed = validInput.data.kind === "blend" ? validInput.data.left : validInput.data.seed;
      if (previous && seed !== previous.output) {
        ctx.addIssue({
          code: "custom",
          path: ["history", index, "input"],
          message: "Continue from the preceding chosen name",
        });
      }
      if (!transformParsedNames(validInput.data).candidates.some((candidate) => candidate.value === step.output)) {
        ctx.addIssue({
          code: "custom",
          path: ["history", index, "output"],
          message: "Output must be a result of the recorded transformation",
        });
      }
    }
    const last = source.history.at(-1);
    if (last && last.output !== source.value) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Name must match the last chosen history output" });
    }
  });
export type NamingSource = z.infer<typeof namingSourceSchema>;
