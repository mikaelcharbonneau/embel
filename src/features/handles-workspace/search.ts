import {
  createEntry,
  handleSourceSchema,
  platformSchema,
  type HandleMatrixRow,
  type HandleNameSource,
  type HandlePlatform,
} from "./domain";

export type HandleSeparator = "" | "." | "_";
export type HandleSearchOptions = { prefixes: string; suffixes: string; separators: HandleSeparator[] };
export const defaultHandleSearch: HandleSearchOptions = {
  prefixes: "get, hello, try",
  suffixes: "hq, studio, co",
  separators: [""],
};

function affixes(value: string): string[] {
  const values = [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (values.length > 6 || values.some((part) => !/^[a-z]{1,16}$/.test(part)))
    throw new Error("Use up to six prefixes or suffixes, each with 1–16 letters. Numbers are not added.");
  return values;
}

/** Conservative local syntax screening, never a claim of availability or platform acceptance. */
export function matchesLocalHandleSyntax(platform: HandlePlatform, value: string): boolean {
  switch (platform) {
    case "instagram":
      return (
        /^[a-z0-9_.]{1,30}$/.test(value) && !value.startsWith(".") && !value.endsWith(".") && !value.includes("..")
      );
    case "tiktok":
      return /^[a-z0-9_.]{2,24}$/.test(value) && !value.endsWith(".");
    case "youtube":
      return /^[a-z0-9][a-z0-9_.-]{1,28}[a-z0-9]$/.test(value);
    case "x":
      return /^[a-z0-9_]{1,15}$/.test(value);
    case "linkedin":
      return /^[a-z0-9-]{5,30}$/.test(value);
  }
}

export function previewHandleSearch(
  sources: HandleNameSource[],
  chosenPlatforms: HandlePlatform[],
  options: HandleSearchOptions,
): { rows: HandleMatrixRow[]; excluded: number } {
  if (!sources.length || sources.length > 30) throw new Error("Enter or import between 1 and 30 names.");
  if (!chosenPlatforms.length) throw new Error("Choose at least one platform.");
  if (!options.separators.length || options.separators.some((value) => !["", ".", "_"].includes(value)))
    throw new Error("Choose at least one separator.");
  const prefixes = affixes(options.prefixes),
    suffixes = affixes(options.suffixes);
  const columns = [...new Set(chosenPlatforms)].map((value) => platformSchema.parse(value));
  const rows: HandleMatrixRow[] = [];
  let excluded = 0;
  const seen = new Set<string>();
  for (const raw of sources) {
    const source = handleSourceSchema.parse(raw);
    const base = source.name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/^@/, "")
      .replace(/\s/g, "")
      .toLowerCase();
    if (!/^[a-z0-9_.-]{1,64}$/.test(base))
      throw new Error("Use names with letters, digits, dots, underscores or hyphens.");
    const candidates = [
      { value: base, variant: "Exact name" },
      ...options.separators.flatMap((separator) => [
        ...prefixes.map((prefix) => ({ value: `${prefix}${separator}${base}`, variant: `${prefix} prefix` })),
        ...suffixes.map((suffix) => ({ value: `${base}${separator}${suffix}`, variant: `${suffix} suffix` })),
      ]),
    ];
    for (const { value, variant } of candidates) {
      const key = `${source.id}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const permitted = columns.filter((platform) => matchesLocalHandleSyntax(platform, value));
      excluded += columns.length - permitted.length;
      if (permitted.length)
        rows.push({ id: key, source, variant, entries: permitted.map((platform) => createEntry(platform, value)) });
      if (rows.length > 120)
        throw new Error("This search is too large. Use fewer names or variations (up to 120 candidate rows).");
    }
  }
  if (!rows.length)
    throw new Error("No candidates match the local syntax rules for these platforms. Adjust the names or platforms.");
  return { rows, excluded };
}
